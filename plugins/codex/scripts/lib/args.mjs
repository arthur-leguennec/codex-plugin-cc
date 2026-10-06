// Fork modification (Apache-2.0 §4(b)): value options never swallow the next flag; raw argument
// splitting keeps Windows paths and apostrophes intact.
// `--model --write` must not read "--write" as the model name; pass `--model=--x` for a
// value that really starts with "--".
function isFlagToken(value) {
  return typeof value === "string" && value.startsWith("--") && value.length > 2;
}

export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined || (inlineValue === undefined && isFlagToken(nextValue))) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined || isFlagToken(nextValue)) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

/**
 * Splits a raw "$ARGUMENTS" string the way a user would expect from a shell, but safely for
 * free text: a backslash only escapes a quote or whitespace (so `C:\Users\me` and
 * `\\server\share` survive), and a quote only opens a quoted section at the start of a token (or after `=`)
 * when a closing quote follows (so "it's slow --base main" keeps its apostrophe and flags).
 */
export function splitRawArgumentString(raw) {
  const characters = [...raw];
  const tokens = [];
  let current = "";
  let started = false;
  let quote = null;

  const pushToken = () => {
    if (started) {
      tokens.push(current);
    }
    current = "";
    started = false;
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];

    if (character === "\\" && next !== undefined && (next === "\"" || next === "'" || /\s/.test(next))) {
      if (quote && next !== quote) {
        current += character;
      } else {
        current += next;
        index += 1;
      }
      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (
      (character === "'" || character === "\"") &&
      (current === "" || current.endsWith("=")) &&
      characters.indexOf(character, index + 1) !== -1
    ) {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      pushToken();
      continue;
    }

    current += character;
    started = true;
  }

  pushToken();
  return tokens;
}
