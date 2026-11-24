# Working with HFT-Engine-Windows

This private repository uses `main` for the reviewed baseline and `Test` for integration.
Open pull requests for changes to `main` and review the Windows checks before merging.

Sierra Chart installations, local configuration, market recordings, model weights and trading
journals belong on the Windows PC. Build replay sessions from data you are authorized to use.
The original upstream history and its recorded fixtures are kept on the local machine.

GitHub Actions builds the dashboard on a GitHub-hosted Windows runner. The Test branch also
runs the synthetic dashboard, paper-execution and Sierra file-format suites. These jobs use a
fresh checkout with no trading credentials, Sierra Chart installation or deployment step.

The runner's `hftbacktest` dependency is pinned as a Git submodule. Its upstream repository and the
corresponding queue-position patch remain listed in `.gitmodules` and `patches/`.
