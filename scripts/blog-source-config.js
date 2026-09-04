const DISCOVERY_TYPES = new Set(['rss', 'sitemap', 'html', 'json']);
const SUPPORTED_PARSERS = new Set(['anthropic-engineering', 'claude-blog', 'qwen-blog']);
const TRACKING_PARAMETERS = /^(?:utm_.+|ref|source)$/i;

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (!isNonemptyString(value)) return false;

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function sourceLabel(source, index) {
  return isNonemptyString(source?.id) ? source.id : `source[${index}]`;
}

function addError(errors, source, index, field, message) {
  errors.push(`${sourceLabel(source, index)}.${field}: ${message}`);
}

function validatePatterns(errors, source, index, field, { required = false } = {}) {
  const patterns = source?.[field];
  if (!Array.isArray(patterns) || (required && patterns.length === 0)) {
    addError(errors, source, index, field, required
      ? 'must be a nonempty array'
      : 'must be an array');
    return;
  }

  patterns.forEach((pattern, patternIndex) => {
    if (!isNonemptyString(pattern)) {
      addError(errors, source, index, `${field}[${patternIndex}]`, 'must be a nonempty string');
      return;
    }

    try {
      new RegExp(pattern);
    } catch (error) {
      addError(errors, source, index, `${field}[${patternIndex}]`, error.message);
    }
  });
}

function matchesPatterns(value, source, patterns) {
  const canonicalUrl = canonicalizeArticleUrl(value, source?.url);
  if (!canonicalUrl) return false;

  let sourceOrigin;
  try {
    sourceOrigin = new URL(source.url).origin;
  } catch {
    return false;
  }
  if (new URL(canonicalUrl).origin !== sourceOrigin) return false;
  return (patterns ?? []).some((pattern) => new RegExp(pattern).test(canonicalUrl));
}

export function validateBlogSources(sources) {
  const errors = [];
  if (!Array.isArray(sources)) {
    return { valid: false, errors: ['sources: must be an array'] };
  }

  const seenIds = new Set();
  sources.forEach((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      addError(errors, source, index, 'source', 'must be an object');
      return;
    }

    for (const field of ['id', 'name', 'language']) {
      if (!isNonemptyString(source[field])) {
        addError(errors, source, index, field, 'is required and must be a nonempty string');
      }
    }

    if (isNonemptyString(source.id)) {
      if (seenIds.has(source.id)) {
        addError(errors, source, index, 'id', 'must be unique');
      }
      seenIds.add(source.id);
    }

    if (!isHttpsUrl(source.url)) {
      addError(errors, source, index, 'url', 'must be an absolute HTTPS URL');
    }

    if (!Array.isArray(source.discovery) || source.discovery.length === 0) {
      addError(errors, source, index, 'discovery', 'must be a nonempty array');
    } else {
      source.discovery.forEach((entry, discoveryIndex) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          addError(errors, source, index, `discovery[${discoveryIndex}]`, 'must be an object');
          return;
        }
        if (!DISCOVERY_TYPES.has(entry.type)) {
          addError(
            errors,
            source,
            index,
            `discovery[${discoveryIndex}].type`,
            'must be one of rss, sitemap, html, or json',
          );
        }
        if (!isHttpsUrl(entry.url)) {
          addError(
            errors,
            source,
            index,
            `discovery[${discoveryIndex}].url`,
            'must be an absolute HTTPS URL',
          );
        }
        if (entry.type === 'json') {
          try {
            if (new URL(entry.url).origin !== new URL(source.url).origin) {
              addError(
                errors,
                source,
                index,
                `discovery[${discoveryIndex}].url`,
                'must use the exact source origin',
              );
            }
          } catch {
            // The absolute HTTPS validation above already reports malformed URLs.
          }
          for (const [field, patterns] of [
            ['publicUrl', source.articleUrlPatterns],
            ['detailUrl', source.fetchUrlPatterns],
          ]) {
            const template = entry[field];
            let validTemplate = isNonemptyString(template) && template.includes('{path}');
            if (validTemplate) {
              try {
                const resolved = new URL(template.replace('{path}', 'example'));
                validTemplate = resolved.protocol === 'https:'
                  && resolved.origin === new URL(source.url).origin
                  && matchesPatterns(resolved.href, source, patterns);
              } catch {
                validTemplate = false;
              }
            }
            if (!validTemplate) {
              addError(
                errors,
                source,
                index,
                `discovery[${discoveryIndex}].${field}`,
                'must be a same-origin HTTPS URL template containing {path} and matching its allow list',
              );
            }
          }
        }
      });
    }

    validatePatterns(errors, source, index, 'articleUrlPatterns', { required: true });
    const emitsFetchUrl = source.discovery?.some((entry) => entry?.type === 'json');
    if (emitsFetchUrl || source.fetchUrlPatterns !== undefined) {
      validatePatterns(errors, source, index, 'fetchUrlPatterns', { required: true });
    }
    if (source.excludeUrlPatterns !== undefined) {
      validatePatterns(errors, source, index, 'excludeUrlPatterns');
    }

    if (source.parser !== undefined && !SUPPORTED_PARSERS.has(source.parser)) {
      addError(errors, source, index, 'parser', 'is not a supported parser');
    }

    if (source.contentSelectors !== undefined) {
      if (!Array.isArray(source.contentSelectors)) {
        addError(errors, source, index, 'contentSelectors', 'must be an array of strings');
      } else {
        source.contentSelectors.forEach((selector, selectorIndex) => {
          if (!isNonemptyString(selector)) {
            addError(
              errors,
              source,
              index,
              `contentSelectors[${selectorIndex}]`,
              'must be a nonempty string',
            );
          }
        });
      }
    }
    if (source.contentSelectorPriority !== undefined
      && typeof source.contentSelectorPriority !== 'boolean') {
      addError(errors, source, index, 'contentSelectorPriority', 'must be a boolean');
    }
    if (source.contentSelectorPriority === true
      && (!Array.isArray(source.contentSelectors) || source.contentSelectors.length === 0)) {
      addError(
        errors,
        source,
        index,
        'contentSelectorPriority',
        'requires nonempty contentSelectors',
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

export function canonicalizeArticleUrl(value, baseUrl) {
  if (!isNonemptyString(value)) return null;

  let url;
  try {
    url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  for (const parameter of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.test(parameter)) url.searchParams.delete(parameter);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');

  return url.href;
}

export function matchesBlogSource(value, source) {
  const canonicalUrl = canonicalizeArticleUrl(value, source?.url);
  if (!canonicalUrl) return false;

  let sourceOrigin;
  try {
    sourceOrigin = new URL(source.url).origin;
  } catch {
    return false;
  }
  if (new URL(canonicalUrl).origin !== sourceOrigin) return false;

  const excluded = (source?.excludeUrlPatterns ?? [])
    .some((pattern) => new RegExp(pattern).test(canonicalUrl));
  if (excluded) return false;

  return (source?.articleUrlPatterns ?? [])
    .some((pattern) => new RegExp(pattern).test(canonicalUrl));
}

export function matchesBlogFetchSource(value, source) {
  return matchesPatterns(value, source, source?.fetchUrlPatterns);
}
