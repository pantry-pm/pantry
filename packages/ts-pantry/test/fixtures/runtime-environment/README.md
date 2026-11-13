This fixture exercises normal package activation with actual SWIG, CMake and
Python, followed by a compiled Python extension. It is a package environment
test; the LLVM recipe's separate LLDB and sanitizer consumers remain required.

`FindPythonAndSwig.cmake` is unmodified from
[LLVM 23.1.5](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.5/lldb/cmake/modules/FindPythonAndSwig.cmake).

SHA256: `0ef0ffe6633202c005e0fe875b598f4d0e58181efa98e6a2b1e450115c1c03ee`.
LLVM's original license is retained as `LLVM-LICENSE.txt`.
