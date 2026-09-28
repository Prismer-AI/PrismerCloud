declare module "pi-web-access/dist/index.js" {
  const extensionFactory: (pi: unknown) => void | Promise<void>;
  export default extensionFactory;
}
