idf_component_register(SRCS "main.c" "ble.c" "out_layer.c" "frame_task.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES bt esp_timer driver nvs_flash)

# Pure payload builders shared with host tests.
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlproto/mlproto.c")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlproto/include")
