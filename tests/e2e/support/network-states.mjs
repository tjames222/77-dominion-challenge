function apiModulePattern(url) {
  const parsed = new URL(url);
  return parsed.pathname.endsWith('/src/static/api.js');
}

function exportedFunctionBodyStart(source, markerIndex, functionName) {
  const parametersStart = source.indexOf('(', markerIndex);
  if (parametersStart < 0) {
    throw new Error('Unable to inspect API function parameters for ' + functionName);
  }

  let depth = 0;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] !== ')') continue;
    depth -= 1;
    if (depth !== 0) continue;
    const bodyStart = source.indexOf('{', index + 1);
    if (bodyStart >= 0) return bodyStart;
    break;
  }
  throw new Error('Unable to inspect API function body for ' + functionName);
}

export function deferApiFunction(page, functionName) {
  let markIntercepted;
  const intercepted = new Promise((resolve) => {
    markIntercepted = resolve;
  });

  page.route(apiModulePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'export async function ' + functionName + '(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error('Unable to defer API function; missing export ' + functionName);
    }
    const bodyStart = exportedFunctionBodyStart(source, markerIndex, functionName);
    const injected = source.slice(0, bodyStart + 1)
      + '\nawait new Promise((resolve) => {\n'
      + '  globalThis.__DOMINION_E2E_DEFERRED_API__ ||= {};\n'
      + '  globalThis.__DOMINION_E2E_DEFERRED_API__[' + JSON.stringify(functionName) + '] = resolve;\n'
      + '});\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
    markIntercepted();
  });

  return {
    intercepted,
    async release() {
      await page.evaluate((name) => {
        const gates = globalThis.__DOMINION_E2E_DEFERRED_API__;
        const release = gates?.[name];
        if (typeof release !== 'function') return;
        delete gates[name];
        release();
      }, functionName);
    },
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
    const bodyStart = exportedFunctionBodyStart(source, markerIndex, functionName);
    const injected = source.slice(0, bodyStart + 1)
      + '\nthrow new Error(' + JSON.stringify(message) + ');\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
  });
}
