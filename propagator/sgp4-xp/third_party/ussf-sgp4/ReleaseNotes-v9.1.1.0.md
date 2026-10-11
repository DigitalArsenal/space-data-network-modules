# Release Notes

## Version 
v9.1.1.0_C_Sgp4Prop_Wasm

## Description
Final release of the C version of Sgp4Prop WebAssembly (Wasm) module that is compliant against v9.1 of the Sgp4Prop Astro Standards Libraries.

## Getting Started
This delivery includes the following items:
* v9.1.1.0_C_Sgp4Prop_Wasm.zip
	* Wasm/build/Sgp4Prop.js (Release)
		* JavaScript file containing runtime support to load and execute the Wasm module
	* Wasm/build/Sgp4Prop.xp.js (XP Release)
		* JavaScript file containing runtime support to load and execute the Wasm module with XP
	* Wasm/build/Sgp4Prop.wasm (Release)
		* WebAssembly file containing the compiled code
	* Wasm/build/Sgp4Prop.xp.wasm (XP Release)
		* WebAssembly file containing the compiled code with XP
	* Wasm/example/Sgp4Prop.html
		* Test page for interacting with the C Sgp4Prop Wasm module
	* Wasm/example/server.bat
		* Batch file used to start a python http server for testing the C Sgp4Prop Wasm module
	* Wasm/docs/ReleaseNotes/v9.1.1.0_C_Wasm_ReleaseNotes.md
		* Markdown file containing release notes
	* Wasm/docs/html/
		* index.html - Documentation for available C Sgp4Prop Wasm interface methods

## Release Notes/Caveats
###This release provides the following capabilities:
* A bug causing slowdown for non-XP deepspace propagation has been fixed
* A bug causing eventual slowdown for XP propagation has been fixed
	* Propagation is now specifically optimized for linear propagation, or repeated propagation of a TLE at a continuously increasing or decreasing time.
		* As such, propagations in a non-linear order may be slower

###Caveats
* In our Sgp4Prop.html examples only, if input TLE files also contain 6P card information, some functions won't parse these files correctly.
* When running our Sgp4Prop.html examples, it is recommended to refresh the browser in between runs. 
* **During testing of this release, it was discovered that certain TLE propagation results didn't match the Fortran Astro Standards baseline results.  This was specific to XP TLEs only.**
	* **Our investigation points to different SHADOW calculations between the Fortran and C baseline due to varying decimal inaccuracy between languages.**
