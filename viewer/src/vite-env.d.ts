/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AWS_CMS_S3_BUCKET_NAME?: string;
  readonly VITE_AWS_CMS_CLOUDFRONT_DISTRIBUTION_DOMAIN?: string;
  readonly VITE_POINTCLOUD_TILES_FOLDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
