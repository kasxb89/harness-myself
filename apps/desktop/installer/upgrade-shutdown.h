// Local installer shutdown protocol. Keep the message and integer parameters in sync with src/installer-shutdown.ts.
#pragma once
#include <windows.h>
#include <tlhelp32.h>
#include <string>

namespace upgrade_shutdown {
constexpr UINT Message = WM_APP + 0x594;
constexpr WPARAM Magic = 0x59554e53;
constexpr LPARAM Version = 1;

inline std::wstring ExecutablePath(LPCWSTR executable) {
    WCHAR path[32768];
    const DWORD count = GetLongPathNameW(executable, path, ARRAYSIZE(path));
    return count > 0 && count < ARRAYSIZE(path) ? path : executable;
}

inline bool ProcessPath(DWORD pid, WCHAR* path, DWORD capacity) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return false;
    const bool found = QueryFullProcessImageNameW(process, 0, path, &capacity) != FALSE;
    CloseHandle(process);
    return found;
}

struct Request { const std::wstring& executable; };

inline BOOL CALLBACK RequestWindow(HWND window, LPARAM value) {
    const auto& request = *reinterpret_cast<const Request*>(value);
    DWORD pid = 0;
    if (GetWindowThreadProcessId(window, &pid) == 0) return TRUE;
    WCHAR path[32768];
    if (ProcessPath(pid, path, ARRAYSIZE(path)) && _wcsicmp(path, request.executable.c_str()) == 0) {
        // The application handles this asynchronously. Do not send WM_CLOSE (which hides to tray),
        // simulate system log-off, terminate a process, or broadcast to another installation.
        PostMessageW(window, Message, Magic, Version);
    }
    return TRUE;
}

inline void RequestShutdown(LPCWSTR executable) {
    const std::wstring path = ExecutablePath(executable);
    const Request request{path};
    EnumWindows(RequestWindow, reinterpret_cast<LPARAM>(&request));
}

// Includes bundled Node/Python/media children that may hold the installation directory after Main exits.
// A component in a sibling directory with the same prefix is never part of this installation.
inline int FindInstallationProcess(LPCWSTR executable) {
    const std::wstring path = ExecutablePath(executable);
    const auto separator = path.find_last_of(L'\\');
    if (separator == std::wstring::npos) return -1;
    const std::wstring root = path.substr(0, separator + 1);
    const LPCWSTR filename = path.c_str() + separator + 1;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return -1;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    int result = 1;
    BOOL present = Process32FirstW(snapshot, &entry);
    while (present) {
        WCHAR candidate[32768];
        if (ProcessPath(entry.th32ProcessID, candidate, ARRAYSIZE(candidate))) {
            if (_wcsnicmp(candidate, root.c_str(), root.size()) == 0) { result = 0; break; }
        } else if (_wcsicmp(entry.szExeFile, filename) == 0) {
            // Do not interpret an inaccessible same-named application as confirmed absence.
            result = -1;
        }
        present = Process32NextW(snapshot, &entry);
    }
    if (!present && GetLastError() != ERROR_NO_MORE_FILES) result = -1;
    CloseHandle(snapshot);
    return result;
}
}
