using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class SshWindows
{
    private const uint Inherit = 1;
    private const int UseStdHandles = 0x100;
    private const uint GenericWrite = 0x40000000;
    private const uint ShareReadWriteDelete = 7;
    private const uint CreateAlways = 2;
    private const uint WaitTimeout = 258;
    private static readonly ControlHandler StopHandler = eventType => eventType == 0;

    private static int Main(string[] args)
    {
        if (args.Length < 2) return 255;
        try
        {
            return Run(args);
        }
        catch (Exception error)
        {
            string message = "Не удалось запустить системный OpenSSH. " + error.Message;
            try { File.AppendAllText(args[1], message + Environment.NewLine); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            Console.Error.WriteLine(message);
            return 255;
        }
    }

    private static int Run(string[] args)
    {
        string executable = args[0];
        string closeRequest = args[1] + ".close";
        var commandLine = new StringBuilder();
        AppendArgument(commandLine, executable);
        for (int i = 2; i < args.Length; i++)
        {
            commandLine.Append(' ');
            AppendArgument(commandLine, args[i]);
        }

        var attributes = new SecurityAttributes {
            Size = Marshal.SizeOf(typeof(SecurityAttributes)),
            InheritHandle = true,
        };
        // Keep stdin and stdout on ConPTY. Redirect diagnostic stderr to a file
        // that the main process can read while OpenSSH is still running.
        var startup = new StartupInfo {
            Size = Marshal.SizeOf(typeof(StartupInfo)),
            Flags = UseStdHandles,
            StandardInput = GetStdHandle(-10),
            StandardOutput = GetStdHandle(-11),
        };
        if (!SetHandleInformation(startup.StandardInput, Inherit, Inherit) ||
            !SetHandleInformation(startup.StandardOutput, Inherit, Inherit))
            throw new Win32Exception();
        // Each launcher belongs to its own pseudoconsole. Ignore the control
        // event in this process so OpenSSH can send its disconnect first.
        if (!SetConsoleCtrlHandler(StopHandler, true)) throw new Win32Exception();

        ProcessInformation child;
        using (var diagnostic = CreateFile(args[1], GenericWrite, ShareReadWriteDelete,
                                           ref attributes, CreateAlways, 0, IntPtr.Zero))
        {
            if (diagnostic.IsInvalid) throw new Win32Exception();
            startup.StandardError = diagnostic.DangerousGetHandle();
            if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0,
                               IntPtr.Zero, null, ref startup, out child))
                throw new Win32Exception();
        }

        CloseHandle(child.Thread);
        try
        {
            uint wait;
            while ((wait = WaitForSingleObject(child.Process, 100)) == WaitTimeout)
            {
                if (!File.Exists(closeRequest)) continue;
                if (GenerateConsoleCtrlEvent(0, 0))
                    wait = WaitForSingleObject(child.Process, 1200);
                else
                    wait = WaitTimeout;
                if (wait == WaitTimeout)
                {
                    TerminateProcess(child.Process, 255);
                    wait = WaitForSingleObject(child.Process, 300);
                }
                break;
            }
            uint code;
            if (wait != 0 || !GetExitCodeProcess(child.Process, out code))
                throw new Win32Exception();
            return unchecked((int)code);
        }
        finally
        {
            CloseHandle(child.Process);
        }
    }

    private static void AppendArgument(StringBuilder command, string argument)
    {
        command.Append('"');
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            command.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            command.Append(character);
            slashes = 0;
        }
        command.Append('\\', slashes * 2).Append('"');
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Size;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedLength;
        public IntPtr ReservedData, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process, Thread;
        public int ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share,
        ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags,
        IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation child);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);

    private delegate bool ControlHandler(uint eventType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint eventType, uint processGroup);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
