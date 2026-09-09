// npm 10 pack returns an array; npm 12 returns a package-name keyed object.
// npm view scalar fields changed from strings to singleton arrays in npm 12.
import { readFileSync } from "node:fs";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packFilename(value, name, version) {
  let result;
  if (Array.isArray(value) && value.length === 1) {
    [result] = value;
  } else if (object(value) && Object.keys(value).length === 1 && Object.hasOwn(value, name)) {
    result = value[name];
  } else {
    throw new Error("npm pack must return exactly one result for the expected package");
  }
  if (!object(result) || result.name !== name || result.version !== version ||
      result.id !== `${name}@${version}`) {
    throw new Error("npm pack result does not identify the expected package and version");
  }
  const filename = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/.test(filename) || result.filename !== filename) {
    throw new Error("npm pack result must contain the expected safe archive basename");
  }
  return filename;
}

function scalar(value) {
  const result = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof result !== "string" || !result || /[\s\x00-\x1f\x7f]/u.test(result)) {
    throw new Error("npm view must return one nonempty scalar string or singleton string array");
  }
  return result;
}

try {
  const [mode, name, version, ...extra] = process.argv.slice(2);
  if (extra.length || (mode !== "pack" && mode !== "view") ||
      (mode === "pack" ? !name || !version : name !== undefined)) {
    throw new Error("usage: npm-json.mjs pack <name> <version> | view (JSON on stdin)");
  }
  const value = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(mode === "pack" ? packFilename(value, name, version) : scalar(value));
} catch (error) {
  console.error(`error: invalid npm JSON: ${error.message}`);
  process.exitCode = 1;
}
