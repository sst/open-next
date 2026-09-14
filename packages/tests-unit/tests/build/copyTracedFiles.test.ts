import {
  isExcluded,
  isNonLinuxPlatformPackage,
  isPackageJson,
} from "@opennextjs/aws/build/copyTracedFiles.js";

describe("isExcluded", () => {
  test("should exclude sharp", () => {
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/sharp/lib/index.js",
      ),
    ).toBe(true);
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/.pnpm/sharp/4.1.3/node_modules/sharp/lib/index.js",
      ),
    ).toBe(true);
    expect(
      isExcluded("/home/user/git/my-opennext-project/node_modules/sharp"),
    ).toBe(true);
  });

  test("should not exclude other packages", () => {
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/other-package/lib/index.js",
      ),
    ).toBe(false);
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/.pnpm/other-package/4.1.3/node_modules/other-package/lib/index.js",
      ),
    ).toBe(false);
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/.pnpm/other-package/4.1.3/node_modules/sharp-other-package/lib/index.js",
      ),
    ).toBe(false);
    expect(
      isExcluded(
        "/home/user/git/my-opennext-project/node_modules/.pnpm/other-package/4.1.3/node_modules/sharp-other",
      ),
    ).toBe(false);
  });
});

describe("isNonLinuxPlatformPackage", () => {
  test("should exclude darwin packages", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@swc/core-darwin-arm64/swc.darwin-arm64.node",
      ),
    ).toBe(true);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@esbuild/darwin-x64/bin/esbuild",
      ),
    ).toBe(true);
  });

  test("should exclude win32 packages", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@swc/core-win32-x64-msvc/swc.win32-x64-msvc.node",
      ),
    ).toBe(true);
  });

  test("should exclude freebsd packages", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@rollup/rollup-freebsd-x64/rollup.freebsd-x64.node",
      ),
    ).toBe(true);
  });

  test("should keep linux packages", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@swc/core-linux-x64-gnu/swc.linux-x64-gnu.node",
      ),
    ).toBe(false);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@swc/core-linux-arm64-gnu/swc.linux-arm64-gnu.node",
      ),
    ).toBe(false);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/@esbuild/linux-x64/bin/esbuild",
      ),
    ).toBe(false);
  });

  test("should keep non-platform packages", () => {
    expect(
      isNonLinuxPlatformPackage("/project/node_modules/@swc/core/index.js"),
    ).toBe(false);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/next/dist/server/next-server.js",
      ),
    ).toBe(false);
  });

  test("should work with pnpm store paths", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/.pnpm/@swc+core-darwin-arm64@1.3.0/node_modules/@swc/core-darwin-arm64/swc.node",
      ),
    ).toBe(true);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/.pnpm/@swc+core-linux-x64-gnu@1.3.0/node_modules/@swc/core-linux-x64-gnu/swc.node",
      ),
    ).toBe(false);
  });

  test("should handle unscoped platform packages", () => {
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/turbo-darwin-arm64/bin/turbo",
      ),
    ).toBe(true);
    expect(
      isNonLinuxPlatformPackage(
        "/project/node_modules/turbo-linux-x64/bin/turbo",
      ),
    ).toBe(false);
  });
});

describe("isPackageJson", () => {
  test("should detect package.json", () => {
    expect(isPackageJson("/project/node_modules/next/package.json")).toBe(true);
    expect(isPackageJson("package.json")).toBe(true);
  });

  test("should not treat files whose names end with 'package.json' as package.json", () => {
    // Regression: traced JSON data files in user code can have names like
    // `care-package.json` that share the "package.json" suffix without being
    // real package manifests. The previous `endsWith("package.json")` check
    // mis-classified them, causing `Failed to copy <dir>` errors in the
    // Cloudflare adapter's workerd-package copy step.
    expect(isPackageJson("/project/data/tables/care-package.json")).toBe(false);
    expect(isPackageJson("/project/fixtures/my-package.json")).toBe(false);
  });

  test("should handle Windows-style path separators", () => {
    expect(isPackageJson("C:\\project\\node_modules\\next\\package.json")).toBe(
      true,
    );
    expect(isPackageJson("C:\\project\\data\\care-package.json")).toBe(false);
  });
});
