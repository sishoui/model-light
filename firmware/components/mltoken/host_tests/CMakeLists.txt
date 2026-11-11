# Host-side unit tests for the pure mltoken component (no ESP-IDF).
cmake_minimum_required(VERSION 3.16)
project(mltoken_host_tests C)

add_executable(test_mltoken test_mltoken.c ../mltoken.c)
target_include_directories(test_mltoken PRIVATE ../include)

enable_testing()
add_test(NAME mltoken COMMAND test_mltoken)
