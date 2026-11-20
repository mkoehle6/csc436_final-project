// Validates render.yaml against Render's published Blueprint JSON schema (D5).
//
//   node scripts/validate-render-yaml.mjs [render.yaml] [schema.json]
//
// With no schema path, the current schema is downloaded from Render, so a
// Blueprint that Render would reject fails CI instead of failing a deploy.
import fs from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const SCHEMA_URL = "https://render.com/schema/render.yaml.json";
const [blueprintPath = "render.yaml", schemaPath] = process.argv.slice(2);

const schema = schemaPath
  ? JSON.parse(fs.readFileSync(schemaPath, "utf8"))
  : await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(15_000) }).then((res) => {
      if (!res.ok) throw new Error(`Could not download ${SCHEMA_URL}: HTTP ${res.status}`);
      return res.json();
    });

const doc = YAML.parseDocument(fs.readFileSync(blueprintPath, "utf8"));
if (doc.errors.length > 0) {
  console.error(`${blueprintPath} is not valid YAML:`);
  for (const err of doc.errors) console.error(`  ${err.message}`);
  process.exit(1);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(doc.toJS())) {
  console.error(`${blueprintPath} does NOT match Render's Blueprint schema:`);
  for (const err of validate.errors ?? []) {
    console.error(`  ${err.instancePath || "/"} ${err.message} ${JSON.stringify(err.params)}`);
  }
  process.exit(1);
}
console.log(`${blueprintPath} is valid against ${schemaPath ?? SCHEMA_URL}`);
