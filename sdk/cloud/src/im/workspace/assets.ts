import type { FileInput, IMAsset, IMAssetListOptions, IMAssetUploadOptions } from '../../types';

export const WORKSPACE_ASSETS_ROUTE = '/api/im/assets' as const;

export type WorkspaceAssetRoute = typeof WORKSPACE_ASSETS_ROUTE;

export type WorkspaceAssetFilters = IMAssetListOptions;

export interface WorkspaceAssetUploadInput extends Omit<IMAssetUploadOptions, 'workspaceId'> {
  workspaceId: string;
  file: FileInput;
}

export interface WorkspaceAssetsApiContract {
  readonly route: WorkspaceAssetRoute;
  uploadAsset(input: WorkspaceAssetUploadInput): Promise<IMAsset>;
  getAsset(id: string): Promise<IMAsset | null>;
  listAssets(workspaceId: string, filters?: WorkspaceAssetFilters): Promise<IMAsset[]>;
  deleteAsset(id: string): Promise<void>;
  getAssetUrl(id: string): Promise<string>;
}
