#!/bin/bash

set -eu

vsce publish $@

OPEN_VSX_TOKEN=$(op item get mx4i5scgxplfxclsbp5rwtpif4 --fields notesPlain)

npx ovsx publish --pat $OPEN_VSX_TOKEN