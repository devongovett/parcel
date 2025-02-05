// This should pass without explicitly listing node in compilerOptions.types.
// The types should be found automatically like they are for tsc.
export default function test(buffer: Buffer) {
  return;
}
