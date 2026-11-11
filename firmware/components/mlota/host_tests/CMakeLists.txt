# Host-side unit tests for the pure mlota component (no ESP-IDF).
cmake_minimum_required(VERSION 3.16)
project(mlota_host_tests C)

add_executable(test_mlota test_mlota.c ../mlota.c ../../mlarr/mlarr.c)
target_include_directories(test_mlota PRIVATE ../include ../../mlarr/include)

enable_testing()
add_test(NAME mlota COMMAND test_mlota)
