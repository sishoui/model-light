idf_component_register(SRCS "main.c" "ble.c" "out_layer.c" "frame_task.c" "store.c"
                       INCLUDE_DIRS "."
                       PRIV_REQUIRES bt esp_timer driver nvs_flash)

# Pure payload builders shared with host tests.
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlproto/mlproto.c")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlproto/include")

# Arrangement TLV codec + rx state machine (host-compilable, no ESP-IDF).
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlarr/mlarr.c")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlarr/include")

# Control-token state machine (F5, host-compilable, no ESP-IDF).
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mltoken/mltoken.c")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mltoken/include")

# Realtime parameter channel (F6, host-compilable, no ESP-IDF).
target_sources(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlrt/mlrt.c")
target_include_directories(${COMPONENT_LIB} PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/../components/mlrt/include")
