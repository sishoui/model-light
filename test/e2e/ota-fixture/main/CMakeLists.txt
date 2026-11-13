# esp_ota_ops / esp_partition：#94 启动时确认 OTA 镜像状态（PENDING_VERIFY →
# VALID），与正式固件 firmware/main 同策略。
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES app_update esp_partition)