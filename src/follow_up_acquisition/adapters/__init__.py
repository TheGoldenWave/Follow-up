"""Source adapters that produce :class:`SourceCandidate` objects for the runtime.

Adapters are source-native collectors; the runtime is the only component allowed
to normalize candidates, assign ``batch_id``, aggregate status, deduplicate, and
serialize Signal Batch envelopes.
"""
