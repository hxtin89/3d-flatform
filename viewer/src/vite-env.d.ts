/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AWS_MEDIA_S3_BUCKET_NAME?: string;
  readonly VITE_AWS_MEDIA_CLOUDFRONT_DISTRIBUTION_DOMAIN?: string;
  readonly VITE_POINTCLOUD_TILES_FOLDER?: string;
  readonly VITE_MAPTILER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
