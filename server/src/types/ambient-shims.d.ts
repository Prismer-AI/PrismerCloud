/**
 * Ambient module shims for self-host build
 *
 * These packages are declared in package.json but may not be installed in
 * every dev environment (e.g., when self-host code references cloud-only deps
 * that aren't relevant locally). Providing minimal `any`-typed shims lets
 * `tsc --noEmit` complete while preserving runtime behavior.
 *
 * Bare `declare module 'x';` makes the module untyped — both default imports
 * and named *value* imports resolve to `any`. For modules where downstream
 * code uses imported names as TYPE annotations, we also export common type
 * aliases as `any`.
 *
 * If/when these packages are installed locally, the real types will take
 * precedence over these shims.
 */

declare module 'qrcode';
declare module '@dnd-kit/utilities';
declare module 'pptx-preview';
declare module 'docx-preview';
declare module 'pdf-parse';
declare module 'rehype-sanitize';
declare module 'vitest';
declare module 'bcryptjs';

// @dnd-kit/core — many type-usages (CollisionDetection, DragStartEvent, etc.)
declare module '@dnd-kit/core' {
  export type CollisionDetection = any;
  export type DragStartEvent = any;
  export type DragOverEvent = any;
  export type DragEndEvent = any;
  export type DragCancelEvent = any;
  export type DragMoveEvent = any;
  export type DragOverlayProps = any;
  export type UniqueIdentifier = any;
  const _default: any;
  export default _default;
  export const DndContext: any;
  export const DragOverlay: any;
  export const PointerSensor: any;
  export const KeyboardSensor: any;
  export const TouchSensor: any;
  export const useSensor: any;
  export const useSensors: any;
  export const closestCenter: any;
  export const closestCorners: any;
  export const pointerWithin: any;
  export const rectIntersection: any;
  export const getFirstCollision: any;
  export const useDroppable: any;
  export const useDraggable: any;
}

declare module '@dnd-kit/sortable' {
  export type SortableContextProps = any;
  const _default: any;
  export default _default;
  export const SortableContext: any;
  export const sortableKeyboardCoordinates: any;
  export const arrayMove: any;
  export const verticalListSortingStrategy: any;
  export const horizontalListSortingStrategy: any;
  export const rectSortingStrategy: any;
  export const useSortable: any;
}

// react-pdf
declare module 'react-pdf' {
  const _default: any;
  export default _default;
  export const Document: any;
  export const Page: any;
  export const pdfjs: any;
}

// react-data-grid
declare module 'react-data-grid' {
  export type Column<T = any, R = any> = any;
  export type RenderCellProps<T = any, R = any> = any;
  export type RenderEditCellProps<T = any, R = any> = any;
  export type CellClickArgs<T = any, R = any> = any;
  export type DataGridProps<T = any> = any;
  export const DataGrid: any;
  const _default: any;
  export default _default;
}

// xlsx
declare module 'xlsx' {
  export const read: any;
  export const readFile: any;
  export const write: any;
  export const writeFile: any;
  export const utils: any;
  export type WorkBook = any;
  export type WorkSheet = any;
  const _default: any;
  export default _default;
}

// @kubernetes/client-node — used as namespace import + named imports
declare module '@kubernetes/client-node' {
  export type KubeConfig = any;
  export type CoreV1Api = any;
  export type BatchV1Api = any;
  export type Exec = any;
  export type V1Pod = any;
  export type V1Job = any;
  export type V1Container = any;
  export type V1PodSpec = any;
  export type V1ObjectMeta = any;
  export type KubernetesObjectApi = any;
  export const KubeConfig: any;
  export const CoreV1Api: any;
  export const BatchV1Api: any;
  export const Exec: any;
  export const KubernetesObjectApi: any;
  const _default: any;
  export default _default;
}

// next-auth — multiple type usages.
// Note: don't declare Session/User here; nextauth.ts augments these via
// `declare module 'next-auth' { interface Session { ... } }`.
declare module 'next-auth' {
  export type NextAuthConfig = any;
  export type NextAuthResult = any;
  export type Account = any;
  export type Profile = any;
  const NextAuth: any;
  export default NextAuth;
}

declare module 'next-auth/providers/credentials';
declare module 'next-auth/providers/google';
declare module 'next-auth/providers/github';
