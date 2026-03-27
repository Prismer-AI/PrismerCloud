// Barrel re-exports — interaction modules
export { screenToCanvas, getZoomLevel, getNodeRenderMode, computeEntryViewport, autoFit } from './viewport';
export { handleWheel, zoomToLevel, getZoomForLevel, MIN_ZOOM, MAX_ZOOM } from './zoom-pan';
export { hitTest, computeHoverState } from './hit-test';
