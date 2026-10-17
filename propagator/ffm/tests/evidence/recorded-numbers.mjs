// Exact equality guards only; numerical scoring remains in C++/WASM.
export function assertRecordedNumbers(actual, recorded, location = '$') {
  if (typeof recorded === 'number') {
    if (!Object.is(actual, recorded))
      throw new Error(`Recorded number changed at ${location}: recorded=${recorded}, actual=${actual}`);
    return;
  }
  if (!recorded || typeof recorded !== 'object') return;
  for (const [key, value] of Object.entries(recorded))
    assertRecordedNumbers(actual?.[key], value, `${location}.${key}`);
}

export function assertMatchingNumbers(actual, recorded, location = '$') {
  if (typeof actual === 'number') {
    assertRecordedNumbers(actual, recorded, location);
    if (typeof recorded !== 'number') throw new Error(`Unrecorded number at ${location}`);
    return;
  }
  if (!actual || typeof actual !== 'object') return;
  for (const [key, value] of Object.entries(actual))
    assertMatchingNumbers(value, recorded?.[key], `${location}.${key}`);
}
