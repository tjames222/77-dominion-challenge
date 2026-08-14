import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultMigrationsDirectory = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
);

const identifierStart = /[A-Za-z_\u0080-\uFFFF]/u;
const identifierPart = /[A-Za-z0-9_$\u0080-\uFFFF]/u;
const dollarTagPart = /[A-Za-z0-9_\u0080-\uFFFF]/u;

function isIdentifierStart(character) {
  return Boolean(character && identifierStart.test(character));
}

function isIdentifierPart(character) {
  return Boolean(character && identifierPart.test(character));
}

function isEscapeStringPrefix(sql, quoteIndex) {
  if (quoteIndex < 1 || !/[eE]/.test(sql[quoteIndex - 1])) return false;
  return !isIdentifierPart(sql[quoteIndex - 2]);
}

function dollarQuoteDelimiterAt(sql, index) {
  if (sql[index] !== "$" || /[0-9]/.test(sql[index + 1] || "")) return null;

  let cursor = index + 1;
  while (cursor < sql.length && dollarTagPart.test(sql[cursor])) cursor += 1;
  if (sql[cursor] !== "$") return null;
  return sql.slice(index, cursor + 1);
}

function tokenizeTopLevelStatements(sql, source) {
  const statements = [];
  const errors = [];
  let statementTokens = [];
  let cursor = 0;
  let line = 1;

  const advance = () => {
    if (sql[cursor] === "\n") line += 1;
    cursor += 1;
  };

  const finishStatement = () => {
    if (statementTokens.length > 0) statements.push(statementTokens);
    statementTokens = [];
  };

  while (cursor < sql.length) {
    const character = sql[cursor];
    const next = sql[cursor + 1];

    if (/\s/u.test(character)) {
      advance();
      continue;
    }

    if (character === "-" && next === "-") {
      while (cursor < sql.length && sql[cursor] !== "\n") advance();
      continue;
    }

    if (character === "/" && next === "*") {
      const commentLine = line;
      let depth = 0;
      while (cursor < sql.length) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
          depth += 1;
          advance();
          advance();
          continue;
        }
        if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
          depth -= 1;
          advance();
          advance();
          if (depth === 0) break;
          continue;
        }
        advance();
      }
      if (depth !== 0) {
        errors.push({
          line: commentLine,
          reason: "unterminated block comment prevents a reliable migration scan",
          source,
        });
      }
      continue;
    }

    if (character === "'") {
      const stringLine = line;
      const escapeBackslashes = isEscapeStringPrefix(sql, cursor);
      advance();
      let terminated = false;
      while (cursor < sql.length) {
        if (escapeBackslashes && sql[cursor] === "\\") {
          advance();
          if (cursor < sql.length) advance();
          continue;
        }
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          advance();
          advance();
          continue;
        }
        if (sql[cursor] === "'") {
          advance();
          terminated = true;
          break;
        }
        advance();
      }
      if (!terminated) {
        errors.push({
          line: stringLine,
          reason: "unterminated string prevents a reliable migration scan",
          source,
        });
      }
      continue;
    }

    if (character === '"') {
      const identifierLine = line;
      advance();
      let terminated = false;
      while (cursor < sql.length) {
        if (sql[cursor] === '"' && sql[cursor + 1] === '"') {
          advance();
          advance();
          continue;
        }
        if (sql[cursor] === '"') {
          advance();
          terminated = true;
          break;
        }
        advance();
      }
      if (!terminated) {
        errors.push({
          line: identifierLine,
          reason: "unterminated quoted identifier prevents a reliable migration scan",
          source,
        });
      }
      continue;
    }

    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(sql, cursor);
      if (delimiter) {
        const dollarQuoteLine = line;
        for (let index = 0; index < delimiter.length; index += 1) advance();

        let terminated = false;
        while (cursor < sql.length) {
          if (sql.startsWith(delimiter, cursor)) {
            for (let index = 0; index < delimiter.length; index += 1) advance();
            terminated = true;
            break;
          }
          advance();
        }
        if (!terminated) {
          errors.push({
            line: dollarQuoteLine,
            reason: `unterminated ${delimiter} body prevents a reliable migration scan`,
            source,
          });
        }
        continue;
      }
    }

    if (character === ";") {
      finishStatement();
      advance();
      continue;
    }

    if (isIdentifierStart(character)) {
      const tokenLine = line;
      const start = cursor;
      advance();
      while (cursor < sql.length && isIdentifierPart(sql[cursor])) advance();
      statementTokens.push({
        line: tokenLine,
        value: sql.slice(start, cursor).toLowerCase(),
      });
      continue;
    }

    advance();
  }

  finishStatement();
  return { errors, statements };
}

function violation(line, reason, source) {
  return { line, reason, source };
}

function inspectStatement(tokens, source) {
  if (tokens.length === 0) return null;

  const words = tokens.map(({ value }) => value);
  const first = words[0];
  const transactionControl =
    first === "begin"
    || first === "commit"
    || first === "rollback"
    || first === "abort"
    || first === "end"
    || (first === "start" && words[1] === "transaction")
    || (first === "prepare" && words[1] === "transaction");

  if (transactionControl) {
    return violation(
      tokens[0].line,
      `${words.slice(0, 2).join(" ").toUpperCase()} is top-level transaction control; pinned Supabase migration up must own the migration transaction`,
      source,
    );
  }

  let cursor = 1;
  if (first === "create" && words[cursor] === "unique") cursor += 1;
  if (
    first === "create"
    && words[cursor] === "index"
    && words[cursor + 1] === "concurrently"
  ) {
    return violation(
      tokens[cursor + 1].line,
      "CREATE INDEX CONCURRENTLY cannot run in the Supabase CLI migration transaction",
      source,
    );
  }

  if (first === "reindex") {
    const concurrentlyIndex = words.indexOf("concurrently", 1);
    if (concurrentlyIndex !== -1) {
      return violation(
        tokens[concurrentlyIndex].line,
        "REINDEX CONCURRENTLY cannot run in the Supabase CLI migration transaction",
        source,
      );
    }
  }

  if (first === "vacuum") {
    return violation(
      tokens[0].line,
      "VACUUM cannot run in the Supabase CLI migration transaction",
      source,
    );
  }

  if (first === "alter" && words[1] === "system") {
    return violation(
      tokens[0].line,
      "ALTER SYSTEM is not compatible with the Supabase CLI migration pipeline",
      source,
    );
  }

  if (first === "cluster") {
    return violation(
      tokens[0].line,
      "CLUSTER cannot run in the Supabase CLI migration transaction",
      source,
    );
  }

  return null;
}

export function migrationCompatibilityViolations(sql, source = "<migration>") {
  const { errors, statements } = tokenizeTopLevelStatements(sql, source);
  const violations = [...errors];

  for (const statement of statements) {
    const found = inspectStatement(statement, source);
    if (found) violations.push(found);
  }

  return violations.sort((left, right) => left.line - right.line);
}

async function migrationFiles(inputPaths) {
  const files = [];
  for (const inputPath of inputPaths) {
    const resolved = path.resolve(inputPath);
    const inputStat = await stat(resolved);
    if (inputStat.isFile()) {
      if (resolved.endsWith(".sql")) files.push(resolved);
      continue;
    }
    if (!inputStat.isDirectory()) continue;

    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".sql")) {
        files.push(path.join(resolved, entry.name));
      }
    }
  }
  return files.sort();
}

export async function checkMigrationCompatibility(
  inputPaths = [defaultMigrationsDirectory],
) {
  const files = await migrationFiles(inputPaths);
  const violations = [];

  for (const file of files) {
    const sql = await readFile(file, "utf8");
    const source = path.relative(repositoryRoot, file) || file;
    violations.push(...migrationCompatibilityViolations(sql, source));
  }

  return { files, violations };
}

async function main() {
  const inputPaths = process.argv.slice(2);
  const result = await checkMigrationCompatibility(
    inputPaths.length > 0 ? inputPaths : [defaultMigrationsDirectory],
  );

  if (result.files.length === 0) {
    throw new Error("No migration SQL files were found.");
  }

  if (result.violations.length > 0) {
    for (const found of result.violations) {
      console.error(`${found.source}:${found.line}: ${found.reason}`);
    }
    throw new Error(
      `Migration compatibility gate rejected ${result.violations.length} statement(s).`,
    );
  }

  console.log(
    `Migration compatibility gate passed: ${result.files.length} migration file(s) use pinned migration-up transaction boundaries.`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
