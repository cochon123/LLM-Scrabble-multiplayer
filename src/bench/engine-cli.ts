import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureParentDir, generateDataset, getDefaultDictionaryPath, inspectCase } from "./case-generator.js";

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(token.slice(2), "true");
      continue;
    }
    parsed.set(token.slice(2), next);
    index += 1;
  }
  return parsed;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === "generate-dataset") {
    const out = args.get("out");
    if (!out) {
      throw new Error("Usage: generate-dataset --out <path> [--count 500 --simple 200 --medium 200 --hard 100 --seed 1]");
    }
    await ensureParentDir(out);
    const cases = await generateDataset({
      count: Number(args.get("count") ?? "500"),
      simple: Number(args.get("simple") ?? "200"),
      medium: Number(args.get("medium") ?? "200"),
      hard: Number(args.get("hard") ?? "100"),
      out,
      seed: Number(args.get("seed") ?? "1"),
      dictionaryPath: args.get("dictionary") ?? getDefaultDictionaryPath()
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        out,
        count: cases.length
      })}\n`
    );
    return;
  }

  if (command === "inspect-case") {
    const dataset = args.get("dataset");
    const caseId = args.get("case-id");
    if (!dataset || !caseId) {
      throw new Error("Usage: inspect-case --dataset <path> --case-id <id>");
    }
    const item = await inspectCase(dataset, caseId);
    if (!item) {
      throw new Error(`Cas introuvable: ${caseId}`);
    }
    process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
    return;
  }

  throw new Error("Commande inconnue. Utilisez generate-dataset ou inspect-case.");
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
