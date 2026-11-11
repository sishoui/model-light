# Top-level project CMake. IDF version floor 5.4 per docs/spec.md §3.2.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(model-light)
set(PARTITION_TABLE_CUSTOM y)
set(PARTITION_TABLE_FILENAME partitions.csv)
set(PARTITION_TABLE_OFFSET 0x8000)

