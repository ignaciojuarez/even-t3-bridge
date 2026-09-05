import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnvironments } from "../src/config.ts";

describe("resolveEnvironments", () => {
  const prevDefault = process.env.EVEN_T3_DEFAULT_PROJECT;
  const prevStudio = process.env.EVEN_T3_TOKEN_STUDIO;

  after(() => {
    if (prevDefault === undefined) delete process.env.EVEN_T3_DEFAULT_PROJECT;
    else process.env.EVEN_T3_DEFAULT_PROJECT = prevDefault;
    if (prevStudio === undefined) delete process.env.EVEN_T3_TOKEN_STUDIO;
    else process.env.EVEN_T3_TOKEN_STUDIO = prevStudio;
  });

  it("always includes local first", () => {
    delete process.env.EVEN_T3_DEFAULT_PROJECT;
    const envs = resolveEnvironments({}, "http://127.0.0.1:3773/", "local-token");
    assert.deepEqual(envs, [
      { id: "local", origin: "http://127.0.0.1:3773", token: "local-token", defaultProject: "" },
    ]);
  });

  it("loads a remote token from tokenPath", () => {
    delete process.env.EVEN_T3_DEFAULT_PROJECT;
    const dir = mkdtempSync(join(tmpdir(), "even-t3-"));
    const tokenPath = join(dir, "studio.token");
    writeFileSync(tokenPath, "studio-secret\n");
    const envs = resolveEnvironments(
      {
        defaultProject: "Demo",
        environments: [
          {
            id: "studio",
            origin: "http://100.1.2.3:3773/",
            tokenPath,
            defaultProject: "Other",
          },
        ],
      },
      "http://127.0.0.1:3773",
      "local-token",
    );
    assert.equal(envs.length, 2);
    assert.equal(envs[0]?.id, "local");
    assert.equal(envs[0]?.defaultProject, "Demo");
    assert.deepEqual(envs[1], {
      id: "studio",
      origin: "http://100.1.2.3:3773",
      token: "studio-secret",
      defaultProject: "Other",
    });
  });

  it("rejects id local", () => {
    assert.throws(
      () =>
        resolveEnvironments(
          { environments: [{ id: "local", origin: "http://example:3773", token: "x" }] },
          "http://127.0.0.1:3773",
          "t",
        ),
      /cannot be 'local'/,
    );
  });
});
