def patch(source):
    s=source
    if 'ownedCollector' not in s:
        s=s.replace("      if (typeof globalThis.addEventListener", "      const ownedCollector = new URLSearchParams(location.search).get('village_collector') === '1';\n      if (!ownedCollector && typeof globalThis.addEventListener")
    s=s.replace("      const response = await fetch(url.toString(), {", "      const response = await fetch(url.toString(), {\n        signal: AbortSignal.timeout(10000),") if 'signal: AbortSignal.timeout(10000)' not in s else s
    return s
