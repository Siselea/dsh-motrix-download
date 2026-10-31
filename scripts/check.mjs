/**
 * Offline sanity check used by CI and `npm test`.
 *
 * Loads the plugin, applies it to a minimal fake Cordis context, then asserts
 * the model-facing contract without touching Motrix or the network:
 *   - exactly the three expected tools are registered
 *   - every tool has a description, parameters, an output schema and a render fn
 *   - output schemas only use keywords accepted by the Harness schema subset
 *   - the system-prompt section is registered with the expected name/order
 *   - registration is owned by ctx.effect (so HMR reloads dispose it)
 */

import assert from 'node:assert/strict'

const { apply } = await import('../index.js')

const tools = new Map()
const sections = []
const effects = []

const ctx = {
  tools: {
    register(definition) {
      assert.equal(typeof definition.name, 'string', 'tool name must be a string')
      assert.ok(!tools.has(definition.name), `duplicate tool: ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(callback) {
    effects.push(callback)
    return callback()
  },
  get(name) {
    if (name !== 'systemPrompt') return undefined
    return {
      section(section) {
        sections.push(section)
        return () => {}
      },
    }
  },
}

apply(ctx)

const EXPECTED_TOOLS = ['download', 'download_control', 'download_status']
assert.deepEqual([...tools.keys()].sort(), EXPECTED_TOOLS, 'unexpected tool set')

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
])

function assertSchemaSupported(schema, path) {
  assert.ok(schema && typeof schema === 'object', `${path}: schema must be an object`)
  for (const key of Object.keys(schema)) {
    assert.ok(SUPPORTED_KEYWORDS.has(key), `${path}: unsupported schema keyword "${key}"`)
  }
  if (schema.properties) {
    assert.equal(typeof schema.properties, 'object', `${path}.properties must be an object`)
    for (const [name, child] of Object.entries(schema.properties)) {
      assertSchemaSupported(child, `${path}.properties.${name}`)
    }
  }
  if (schema.items) assertSchemaSupported(schema.items, `${path}.items`)
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((child, index) => assertSchemaSupported(child, `${path}.oneOf[${index}]`))
  }
}

for (const name of EXPECTED_TOOLS) {
  const tool = tools.get(name)
  assert.equal(typeof tool.description, 'string', `${name}: missing description`)
  assert.ok(tool.description.length > 10, `${name}: description too short`)
  assert.equal(typeof tool.execute, 'function', `${name}: missing execute`)
  assert.ok(tool.parameters && tool.parameters.type === 'object', `${name}: parameters must be an object schema`)
  assert.equal(tool.parameters.additionalProperties, false, `${name}: parameters must forbid unknown keys`)
  assert.ok(tool.output, `${name}: missing output declaration`)
  assert.equal(typeof tool.output.render, 'function', `${name}: output.render must be a function`)
  assertSchemaSupported(tool.output.schema, `${name}.output.schema`)
}

// download: save_dir is mandatory, engine is a closed enum.
const downloadParams = tools.get('download').parameters
assert.deepEqual(downloadParams.required.sort(), ['save_dir', 'url'], 'download: url and save_dir are required')
assert.deepEqual(downloadParams.properties.engine.enum, ['auto', 'motrix', 'direct'])

// The prompt section must be registered once, with a stable identity.
assert.equal(sections.length, 1, 'expected exactly one prompt section')
assert.equal(sections[0].name, 'motrix-download')
assert.equal(sections[0].order, 5900)
assert.ok(sections[0].text.includes('save_dir'), 'prompt section must require save_dir')

// Every registration must be owned by ctx.effect so unload/HMR disposes it.
assert.ok(effects.length >= 4, `expected 4+ effect-owned registrations, got ${effects.length}`)

console.log(`OK: ${EXPECTED_TOOLS.length} tools, 1 prompt section, schemas within the supported subset`)
