# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The containers and virtual machines of an Incus server (or LXD) in Gladys,
  through the Incus REST API over HTTPS: one device per instance, identified
  by its name and project, with Running (a switch that starts and stops it),
  CPU, Memory and IP address; a device for the server with its reachability,
  its version and the counts of instances running and in total.
- Trust by the token of `incus config trust add`, with a client certificate
  created by the integration, and the server certificate pinned by its
  fingerprint.
- Scene triggers: instance stopped unexpectedly (not the stops asked by
  Gladys), Incus unreachable.
- Scene actions and configuration buttons: start, stop and restart an
  instance; Test the connection; Trust the server certificate again.
- Dashboard widget: instances running and in error, the list of the instances
  with the problems first, Start or Stop and Restart buttons for a chosen
  instance.
