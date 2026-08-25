const HTML_EXTENSION = '.html';

export function canonicalHtmlRouteFileName(pathname = '') {
  const path = String(pathname || '').split(/[?#]/, 1)[0];
  const fileName = path.split('/').filter(Boolean).pop() || `index${HTML_EXTENSION}`;
  if (fileName.endsWith(HTML_EXTENSION) || fileName.includes('.')) return fileName;
  return `${fileName}${HTML_EXTENSION}`;
}

export function canonicalHtmlRoutePath(pathname = '') {
  return `/${canonicalHtmlRouteFileName(pathname)}`;
}
