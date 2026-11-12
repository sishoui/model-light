// OTA 图像元数据 — 将 imageSize/sha256/appVersion/crc32/data 五参数打包为一类。
// 纯记录型，无 wx 依赖，Node/vitest 可单测。
//
// 决策：ota-session.begin() 与 ota-commit.begin() 均统一以本类型携带图像元数据，
// 避免五个散参在两模块间反复打捆。

/** OTA 图像元数据。 */
function createOtaImage({
  imageSize,
  sha256,
  appVersion,
  crc32,
  data,
} = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  return {
    imageSize: imageSize !== undefined ? imageSize : bytes.length,
    sha256: sha256 instanceof Uint8Array ? sha256 : null,
    appVersion: appVersion || '',
    crc32: crc32 !== undefined ? crc32 : 0,
    data: bytes,
  };
}

module.exports = { createOtaImage };
