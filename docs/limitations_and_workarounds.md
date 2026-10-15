# Workarounds

- Modern Image Format Support
  - Currently No LLM/Embedding Providers support AVIF/JXL images, but both of them are quite suitable for significantly reducing file sizes.
  - Since AVIF is so widely spread and all major browsers supports it, it is no wonder that these providers would support it.
  - When it comes to JXL, things get different. JXL is considered a wonderful replacement for JPEG and PNG, if without Google's rejection to adopt JXL, it would also be widely spread. Google realized that and developed a pure Rust JXL decoding library which is what Chrome and Firefox rely on to decode JXL images. Now since Safari 17+, Chrome 155+ and Firefox 158+ support JXL, with the giant advantages, its adoption would be soaring in the near future. Therefore, supporting JXL images is a must for AI providers in the providers, for reducing bandwidth costs and storage costs, and for better image quality.
  - But for now, no providers support it. We have to decode it manually and pass it to AI providers.
  - Each generation or embedding model can declare its accepted `image/*` MIME types.
    - Images are always sent as bytes. Accepted formats within 1536 px on the long edge and 4 MB pass through unchanged.
    - Everything else is EXIF-rotated, shrunk to fit 1536 px and transcoded to an accepted JPEG or WebP (PNG only as a last resort) when the decoder supports it.
    - Generated covers are AVIF (at most 1440 px), so a model that declares `image/avif` receives them without any conversion. Declare formats per model under "Supported image formats".
    - The bundled decoder reads AVIF but not JXL: a JXL original can only be used by models that declare `image/jxl`.
