import { describe, expect, it } from "vitest";
import { checkDangerousCommand, compileCommandPatterns } from "./dangerous";

const patterns = compileCommandPatterns([]);

function check(cmd: string) {
  return checkDangerousCommand({
    command: cmd,
    patterns,
    useBuiltinMatchers: true,
    fallbackPatterns: [],
  });
}

describe("adversarial bypass regression", () => {
  it("catches powershell -Command quoted taskkill via nested rescan", () => {
    const r = check('powershell -Command "taskkill /IM omp.exe"');
    expect(r?.description).toContain("host runtime mass kill");
  });

  it("catches cmd /c unquoted taskkill via nested rescan", () => {
    const r = check("cmd /c taskkill /IM omp.exe");
    expect(r?.description).toContain("host runtime mass kill");
  });

  it("catches powershell -Command Stop-Process via nested rescan", () => {
    const r = check('powershell -Command "Stop-Process -Name node"');
    expect(r?.description).toContain("host runtime mass kill");
  });

  it("catches powershell -c quoted taskkill", () => {
    const r = check('powershell -c "taskkill /IM omp.exe"');
    expect(r?.description).toContain("host runtime mass kill");
  });

  it("still allows echo with killer text", () => {
    const r = check('echo "taskkill /IM omp.exe"');
    expect(r).toBeUndefined();
  });

  it("still allows taskkill /PID", () => {
    const r = check("taskkill /PID 1234");
    expect(r).toBeUndefined();
  });
});
