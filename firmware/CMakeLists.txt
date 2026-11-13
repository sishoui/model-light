# Top-level project CMake. IDF version floor 5.4 per docs/spec.md §3.2.
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(model-light)

# Partition-table selection is Kconfig (see CONFIG_PARTITION_TABLE_CUSTOM in
# sdkconfig.defaults); the partition_table component reads the CSV from there.

