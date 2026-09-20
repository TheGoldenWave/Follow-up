"""Resolve configured credential references into closed tagged resolutions.

A credential reference exists only in user configuration
(``acquisition.sourceCredentials["<source-id>"] = {"ref": "env.VARIABLE"}``) and
never inside the source registry. Resolution returns exactly one of three closed
shapes: ``{"status": "absent"}``, ``{"status": "resolved", "token": ...}`` or
``{"status": "resolution-error"}``; adapters fail closed on anything else.

A credential that is configured but unusable never degrades into anonymous
requests: a stale or malformed variable stays visible as ``resolution-error``
instead of silently lowering request limits.
"""

from __future__ import annotations

import os
import re
from collections.abc import Callable, Mapping
from typing import Any

# ``1..4096`` Latin-1 bytes with no C0/C1/DEL is what an ``Authorization``
# header value can carry verbatim, so it is also what a resolved token must
# satisfy before any request is attempted.
MAX_TOKEN_BYTES = 4096
CREDENTIAL_REF_RE = re.compile(r"^env\.[A-Z_][A-Z0-9_]{0,127}$")
_ENV_PREFIX = "env."


class CredentialRefError(ValueError):
    """Raised when a credential reference is not exactly ``env.VARIABLE_NAME``."""


def is_valid_token(value: Any) -> bool:
    """Return whether ``value`` is usable verbatim as an ``Authorization`` value."""
    if type(value) is not str or not value or value != value.strip():
        return False
    try:
        encoded = value.encode("latin-1")
    except UnicodeEncodeError:
        return False
    if len(encoded) > MAX_TOKEN_BYTES:
        return False
    return not any(byte < 0x20 or 0x7F <= byte <= 0x9F for byte in encoded)


def parse_credential_refs(pairs: Any) -> dict[str, str]:
    """Parse ``SOURCE_ID=env.VARIABLE`` pairs into ``{source_id: variable}``.

    Source ids are validated against the loaded registry by the caller so a
    typo cannot silently disable a configured credential.
    """
    refs: dict[str, str] = {}
    for pair in pairs or ():
        if type(pair) is not str or pair.count("=") != 1:
            raise CredentialRefError("credential reference must be SOURCE_ID=env.VARIABLE")
        source_id, ref = pair.split("=", 1)
        if not source_id or source_id != source_id.strip():
            raise CredentialRefError("credential reference must name a stable source_id")
        if CREDENTIAL_REF_RE.fullmatch(ref) is None:
            raise CredentialRefError("credential reference must use env.VARIABLE_NAME")
        if source_id in refs:
            raise CredentialRefError("credential reference must be unique per source_id")
        refs[source_id] = ref[len(_ENV_PREFIX):]
    return refs


def build_credential_resolver(
    refs: Mapping[str, str],
    environ: Mapping[str, str] | None = None,
) -> Callable[[str], dict[str, str]]:
    """Return a resolver mapping a source id to its closed credential resolution."""
    environment = os.environ if environ is None else environ

    def resolve(source_id: str) -> dict[str, str]:
        variable = refs.get(source_id)
        if variable is None:
            return {"status": "absent"}
        token = environment.get(variable)
        if not is_valid_token(token):
            return {"status": "resolution-error"}
        return {"status": "resolved", "token": token}

    return resolve
