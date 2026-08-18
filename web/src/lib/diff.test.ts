import { describe, expect, it } from "vitest";
import { diffStat, foldContext, parseDiff } from "./diff";

const SAMPLE = `diff --git a/internal/backup/run.go b/internal/backup/run.go
index 1a2b3c4..5d6e7f8 100644
--- a/internal/backup/run.go
+++ b/internal/backup/run.go
@@ -10,7 +10,8 @@ func Run(ctx context.Context) error {
 	if err := prepare(ctx); err != nil {
 		return err
 	}
-	return upload(ctx)
+	if err := upload(ctx); err != nil {
+		return fmt.Errorf("upload: %w", err)
+	}
+	return nil
 }

 func prepare(ctx context.Context) error {
diff --git a/web/src/app.ts b/web/src/app.ts
new file mode 100644
--- /dev/null
+++ b/web/src/app.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

describe("parseDiff", () => {
  it("splits files and keeps the new path", () => {
    const files = parseDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["internal/backup/run.go", "web/src/app.ts"]);
  });

  it("counts additions and deletions per file", () => {
    const [first, second] = parseDiff(SAMPLE);
    expect(first?.adds).toBe(4);
    expect(first?.dels).toBe(1);
    expect(second?.adds).toBe(2);
    expect(second?.dels).toBe(0);
    expect(second?.status).toBe("added");
  });

  it("numbers lines from the hunk header", () => {
    const [first] = parseDiff(SAMPLE);
    const lines = first?.hunks[0]?.lines ?? [];
    expect(lines[0]).toMatchObject({ kind: "ctx", oldNo: 10, newNo: 10 });
    const removed = lines.find((l) => l.kind === "del");
    expect(removed).toMatchObject({ oldNo: 13, newNo: null });
    expect(removed?.text).toBe("\treturn upload(ctx)");
  });

  it("survives text that is not a diff at all", () => {
    expect(parseDiff("just some prose the agent pasted")).toEqual([]);
  });

  it("totals across files", () => {
    expect(diffStat(parseDiff(SAMPLE))).toEqual({ files: 2, adds: 6, dels: 1 });
  });
});

describe("foldContext", () => {
  it("folds runs of context longer than the window", () => {
    const lines = [
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: "ctx" as const,
        text: `ctx ${i}`,
        oldNo: i,
        newNo: i,
      })),
      { kind: "add" as const, text: "new", oldNo: null, newNo: 13 },
    ];
    const rows = foldContext(lines);
    const fold = rows.find((r) => r.kind === "fold");
    expect(fold).toBeDefined();
    // Leading context before the first change keeps only the trailing window.
    expect(fold && fold.kind === "fold" ? fold.count : 0).toBe(9);
    expect(rows.at(-1)).toMatchObject({ kind: "line" });
  });

  it("leaves short runs alone", () => {
    const lines = [
      { kind: "ctx" as const, text: "a", oldNo: 1, newNo: 1 },
      { kind: "del" as const, text: "b", oldNo: 2, newNo: null },
      { kind: "ctx" as const, text: "c", oldNo: 3, newNo: 2 },
    ];
    expect(foldContext(lines).every((r) => r.kind === "line")).toBe(true);
  });
});
