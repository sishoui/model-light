# Host-side unit tests for the pure mlrt component (no ESP-IDF).
cmake_minimum_required(VERSION 3.16)
project(mlrt_host_tests C)

add_executable(test_mlrt test_mlrt.c ../mlrt.c ../../mlarr/mlarr.c)
target_include_directories(test_mlrt PRIVATE ../include ../../mlarr/include)

enable_testing()
add_test(NAME mlrt COMMAND test_mlrt)
