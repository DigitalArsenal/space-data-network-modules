// Build-time C++ literal generation, separate from typed runtime data encoding.
// Octal escapes have exactly three digits, so an adjacent hex/digit character
// cannot extend an escape. Encode UTF-8 bytes explicitly for compiler parity.
export function cppString(value) {
  return '"'+[...Buffer.from(value,'utf8')].map(byte=>
    byte>=32 && byte<=126 && byte!==34 && byte!==92?String.fromCharCode(byte):
      '\\'+byte.toString(8).padStart(3,'0')).join('')+'"';
}

// Human-readable build evidence; never a module input or wire format.
export function buildRecord(fields) {
  return '# Body appearance build provenance\n\n'+Object.entries(fields)
    .map(([name,value])=>`- ${name}: ${Array.isArray(value)?value.join(', '):value}`).join('\n')+'\n';
}
