function apiModulePattern(url) {
  const parsed = new URL(url);
  return parsed.pathname.endsWith('/src/static/api.js');
}

export function deferApiModule(page) {
  let releaseRequest;
  let markIntercepted;
  const releasePromise = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  const intercepted = new Promise((resolve) => {
    markIntercepted = resolve;
  });

  page.route(apiModulePattern, async (route) => {
    markIntercepted();
    await releasePromise;
    await route.continue();
  });

  return {
    intercepted,
    release: releaseRequest,
  };
}

export async function injectApiFunctionFailure(page, functionName, message) {
  await page.route(apiModulePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'export async function ' + functionName + '(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error('Unable to inject API failure; missing export ' + functionName);
    }
    const bodyStart = source.indexOf('{', markerIndex);
    if (bodyStart < 0) {
      throw new Error('Unable to inject API failure; missing function body for ' + functionName);
    }
    const injected = source.slice(0, bodyStart + 1)
      + '\nthrow new Error(' + JSON.stringify(message) + ');\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
  });
}
