# Host-side unit tests for the pure mlarr component (no ESP-IDF).
cmake_minimum_required(VERSION 3.16)
project(mlarr_host_tests C)

add_executable(test_mlarr test_mlarr.c ../mlarr.c)
target_include_directories(test_mlarr PRIVATE ../include)

enable_testing()
add_test(NAME mlarr COMMAND test_mlarr)
