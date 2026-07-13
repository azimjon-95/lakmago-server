#!/bin/bash
# lakma-server -> GitHub push
git remote remove origin 2>/dev/null
git remote add origin https://github.com/azimjon-95/lakma-server.git
git branch -M main
git push -u origin main
