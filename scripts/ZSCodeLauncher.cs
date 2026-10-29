using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("ZSCode")]
[assembly: AssemblyProduct("ZilpioStudioCode")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class ZSCodeLauncher
{
	[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
	private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
	[STAThread]
	private static int Main(string[] args)
	{
		try
		{
			Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID("ZilpioStudioCode.Editor"));
			string root = AppDomain.CurrentDomain.BaseDirectory;
			string script = Path.Combine(root, "scripts", "preview-zilpio.ps1");
			if (!File.Exists(script)) { throw new FileNotFoundException("Mantieni ZSCode.exe nella cartella ZilpioStudioCode: manca scripts\\preview-zilpio.ps1."); }
			// Preserve native Jump List arguments, including folder/file URIs and -n.
			// Base64 tokens cross PowerShell without interpreting paths as script code.
			string encodedArguments = String.Join(",", Array.ConvertAll(args,
				value => Convert.ToBase64String(Encoding.UTF8.GetBytes(value))));
			var start = new ProcessStartInfo
			{
				FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
				Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File " + Quote(script) +
					(args.Length == 0 ? "" : " -EncodedArguments " + Quote(encodedArguments)),
				WorkingDirectory = root,
				UseShellExecute = false,
				CreateNoWindow = true,
				RedirectStandardOutput = true,
				RedirectStandardError = true
			};
			using (Process process = Process.Start(start))
			{
				Task<string> output = process.StandardOutput.ReadToEndAsync();
				Task<string> error = process.StandardError.ReadToEndAsync();
				process.WaitForExit();
				Task.WaitAll(output, error);
				if (process.ExitCode != 0) { throw new InvalidOperationException(error.Result + Environment.NewLine + output.Result); }
			}
			return 0;
		}
		catch (Exception error)
		{
			MessageBox.Show(error.Message, "Avvio ZSCode non riuscito", MessageBoxButtons.OK, MessageBoxIcon.Error);
			return 1;
		}
	}

	private static string Quote(string value)
	{
		// Double trailing backslashes so the closing command-line quote stays literal.
		if (value.Contains("\"")) { throw new ArgumentException("Percorso non valido."); }
		return "\"" + value + new string('\\', value.Length - value.TrimEnd('\\').Length) + "\"";
	}
}
