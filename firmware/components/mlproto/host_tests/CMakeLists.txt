# Host-side unit tests for the pure mlproto component (no ESP-IDF).
cmake_minimum_required(VERSION 3.16)
project(mlproto_host_tests C)

add_executable(test_mlproto test_mlproto.c ../mlproto.c)
target_include_directories(test_mlproto PRIVATE ../include)

enable_testing()
add_test(NAME mlproto COMMAND test_mlproto)
