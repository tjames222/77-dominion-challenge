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

let deferredApiSignalSequence = 0;

export async function deferApiFunction(page, functionName) {
  let markIntercepted;
  const intercepted = new Promise((resolve) => {
    markIntercepted = resolve;
  });
  deferredApiSignalSequence += 1;
  const signalName = '__dominionE2eDeferredApiStarted' + deferredApiSignalSequence;
  await page.exposeFunction(signalName, markIntercepted);

  await page.route(apiModulePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'export async function ' + functionName + '(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error('Unable to defer API function; missing export ' + functionName);
    }
    const bodyStart = exportedFunctionBodyStart(source, markerIndex, functionName);
    const key = JSON.stringify(functionName);
    const injected = source.slice(0, bodyStart + 1)
      + '\nglobalThis.__DOMINION_E2E_API_CALL_COUNTS__ ||= {};\n'
      + 'globalThis.__DOMINION_E2E_API_CALL_COUNTS__[' + key + '] = '
      + '(globalThis.__DOMINION_E2E_API_CALL_COUNTS__[' + key + '] || 0) + 1;\n'
      + 'globalThis.__DOMINION_E2E_DEFERRED_API__ ||= {};\n'
      + 'let injectedDeferredApiGate = globalThis.__DOMINION_E2E_DEFERRED_API__[' + key + '];\n'
      + 'if (!injectedDeferredApiGate) {\n'
      + '  let releaseInjectedDeferredApi;\n'
      + '  const injectedDeferredApiPromise = new Promise((resolve) => { releaseInjectedDeferredApi = resolve; });\n'
      + '  injectedDeferredApiGate = { promise: injectedDeferredApiPromise, release: releaseInjectedDeferredApi };\n'
      + '  globalThis.__DOMINION_E2E_DEFERRED_API__[' + key + '] = injectedDeferredApiGate;\n'
      + '}\n'
      + 'void globalThis[' + JSON.stringify(signalName) + ']();\n'
      + 'await injectedDeferredApiGate.promise;\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
  });

  return {
    intercepted,
    async release() {
      await intercepted;
      await page.evaluate((name) => {
        const gates = globalThis.__DOMINION_E2E_DEFERRED_API__;
        const gate = gates?.[name];
        if (typeof gate?.release !== 'function') {
          throw new Error('Deferred API function was not waiting: ' + name);
        }
        delete gates[name];
        gate.release();
      }, functionName);
    },
    count: () => page.evaluate(
      (name) => globalThis.__DOMINION_E2E_API_CALL_COUNTS__?.[name] || 0,
      functionName,
    ),
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

export async function injectApiFunctionFailureOnce(page, functionName, message) {
  await page.route(apiModulePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'export async function ' + functionName + '(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error('Unable to inject API failure; missing export ' + functionName);
    }
    const bodyStart = exportedFunctionBodyStart(source, markerIndex, functionName);
    const key = JSON.stringify(functionName);
    const injected = source.slice(0, bodyStart + 1)
      + '\nglobalThis.__DOMINION_E2E_API_FAILURE_COUNTS__ ||= {};\n'
      + 'const injectedFailureCount = globalThis.__DOMINION_E2E_API_FAILURE_COUNTS__[' + key + '] || 0;\n'
      + 'globalThis.__DOMINION_E2E_API_FAILURE_COUNTS__[' + key + '] = injectedFailureCount + 1;\n'
      + 'if (injectedFailureCount === 0) throw new Error(' + JSON.stringify(message) + ');\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
  });
}

export async function countApiFunctionCalls(page, functionName) {
  await page.route(apiModulePattern, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = 'export async function ' + functionName + '(';
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error('Unable to count API calls; missing export ' + functionName);
    }
    const bodyStart = exportedFunctionBodyStart(source, markerIndex, functionName);
    const key = JSON.stringify(functionName);
    const injected = source.slice(0, bodyStart + 1)
      + '\nglobalThis.__DOMINION_E2E_API_CALL_COUNTS__ ||= {};\n'
      + 'globalThis.__DOMINION_E2E_API_CALL_COUNTS__[' + key + '] = '
      + '(globalThis.__DOMINION_E2E_API_CALL_COUNTS__[' + key + '] || 0) + 1;\n'
      + source.slice(bodyStart + 1);
    await route.fulfill({ response, body: injected });
  });

  return {
    count: () => page.evaluate(
      (name) => globalThis.__DOMINION_E2E_API_CALL_COUNTS__?.[name] || 0,
      functionName,
    ),
  };
}
