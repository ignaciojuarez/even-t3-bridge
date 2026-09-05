import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverTailscaleT3, envIdFromDns, firstT3Origin, pairingCredential, parsePeerTargets } from "../src/discover.ts";

describe("envIdFromDns", () => {
  it("uses the MagicDNS label", () => {
    assert.equal(envIdFromDns("studio-mac.example.ts.net."), "studio-mac");
  });
});

describe("parsePeerTargets", () => {
  const status = {
    Self: { TailscaleIPs: ["100.64.0.1"] },
    Peer: {
      a: {
        Online: true,
        OS: "macOS",
        DNSName: "studio-mac.example.ts.net.",
        TailscaleIPs: ["100.64.0.2"],
      },
      b: { Online: true, OS: "iOS", DNSName: "phone.example.ts.net.", TailscaleIPs: ["100.64.0.3"] },
      c: { Online: false, OS: "macOS", DNSName: "offline.example.ts.net.", TailscaleIPs: ["100.64.0.4"] },
    },
  };

  it("keeps online desktop peers and skips self/ios/offline", () => {
    const rows = parsePeerTargets(status, new Set(["100.64.0.1"]));
    assert.deepEqual(rows, [
      {
        id: "studio-mac",
        origins: ["http://100.64.0.2:3773", "https://studio-mac.example.ts.net"],
      },
    ]);
  });
});

describe("firstT3Origin", () => {
  it("returns the first origin that serves a T3 environment descriptor", async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.startsWith("http://100.64.0.2:3773/")) {
        return new Response(JSON.stringify({ environmentId: "abc" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    };
    assert.equal(await firstT3Origin(["http://100.64.0.2:3773", "https://nope"], fetchImpl as typeof fetch), "http://100.64.0.2:3773");
    assert.equal(await firstT3Origin(["https://nope"], fetchImpl as typeof fetch), null);
  });
});

describe("discoverTailscaleT3", () => {
  const status = {
    Self: { TailscaleIPs: ["100.64.0.1"] },
    Peer: {
      a: {
        Online: true,
        OS: "macOS",
        DNSName: "studio.example.ts.net.",
        TailscaleIPs: ["100.64.0.2"],
      },
    },
  };

  it("adds a reachable peer when a bearer exists", async () => {
    const { found, pending } = await discoverTailscaleT3({
      takenIds: new Set(["local"]),
      takenOrigins: new Set(["http://127.0.0.1:3773"]),
      status,
      tokenFor: () => "remote-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ environmentId: "abc" }), { status: 200 })) as typeof fetch,
    });
    assert.deepEqual(found, [
      { id: "studio", origin: "http://100.64.0.2:3773", token: "remote-token", defaultProject: "" },
    ]);
    assert.equal(pending.length, 0);
  });

  it("lists a reachable peer with no bearer as pending", async () => {
    const { found, pending } = await discoverTailscaleT3({
      takenIds: new Set(["local"]),
      takenOrigins: new Set(),
      status,
      tokenFor: () => undefined,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ environmentId: "abc" }), { status: 200 })) as typeof fetch,
    });
    assert.equal(found.length, 0);
    assert.match(pending[0] ?? "", /t3_pair_studio/);
  });
});

describe("pairingCredential", () => {
  it("accepts a raw code or a /pair URL", () => {
    assert.equal(pairingCredential("  PAIRCODE1  "), "PAIRCODE1");
    assert.equal(pairingCredential("http://100.64.0.2:3773/pair?token=PAIRCODE1"), "PAIRCODE1");
    assert.equal(pairingCredential("http://192.0.2.10:3773/pair#token=PAIRCODE2"), "PAIRCODE2");
  });
});
