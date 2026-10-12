# Go version management with asdf

Go versions are managed with [asdf](https://asdf-vm.com). The plugin is named `golang`. For a general introduction to the Go toolchain, see the [Go README](README.md).

## Check versions

```sh
asdf list golang          # installed versions
asdf current golang       # active version and the .tool-versions file it comes from
```

## Change the global Go version

The global default is set in `~/.tool-versions` and applies everywhere no project-level pin exists:

```sh
asdf set --home golang <version>      # set global default
```

Example, switching the global version to 1.27.1:

```sh
asdf set --home golang 1.27.1
```

This results in `~/.tool-versions`:

```
golang 1.27.1
```

## Override per project

asdf resolves the version from the closest `.tool-versions` file walking up the directory tree, so a project-level pin always wins over the global default:

```sh
asdf set --parent golang <version>    # write pin into closest existing parent .tool-versions
```

## Install a new version

```sh
asdf plugin update golang             # refresh available versions
asdf install golang <version>
asdf reshim golang                    # only needed if shims seem stale
```