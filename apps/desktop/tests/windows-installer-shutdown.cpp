// Test driver for the real x86 installer DLL. Does not terminate or install any process.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <string>

extern "C" __declspec(dllimport) void __cdecl InstallerRequestShutdown(LPCWSTR executable);
extern "C" __declspec(dllimport) int __cdecl InstallerFindInstallationProcess(LPCWSTR executable);

int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 64;
    const std::wstring action = argv[1];
    if (action == L"request") InstallerRequestShutdown(argv[2]);
    else if (action != L"find") return 64;
    const int result = InstallerFindInstallationProcess(argv[2]);
    std::printf("{\"installationProcessState\":%d}\n", result);
    return result < 0 ? 2 : 0;
}
