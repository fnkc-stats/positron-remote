// Shell scripts are imported as text (esbuild --loader:.sh=text)
declare module '*.sh' {
  const text: string;
  export default text;
}
declare module '*.R' {
  const text: string;
  export default text;
}
