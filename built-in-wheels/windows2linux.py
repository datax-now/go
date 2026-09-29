#!/usr/bin/env python3
"""
Convert Windows-style paths to POSIX paths in Python wheel package.json files.

This script fixes JupyterLab extensions built on Windows for Linux/POSIX compatibility.
Windows wheels often contain backslash path separators in package.json metadata,
which JupyterLite silently rejects on Linux systems.

Usage:
    python windows2linux.py <wheel_file>
    
Example:
    python windows2linux.py datax_now_front-0.1.60-py3-none-any.whl
"""

import sys
import zipfile
import json
import tempfile
import shutil
from pathlib import Path


def find_package_json_in_wheel(wheel_path):
    """
    Find the package.json file in a JupyterLab extension wheel.
    
    Returns:
        str: Path to package.json inside the wheel, or None if not found
    """
    with zipfile.ZipFile(wheel_path, 'r') as z:
        # Look for package.json in labextensions directory
        for name in z.namelist():
            if '/labextensions/' in name and name.endswith('/package.json'):
                return name
    return None


def fix_wheel(wheel_path):
    """
    Fix Windows backslashes in a wheel's package.json file.
    
    Args:
        wheel_path: Path to the wheel file (str or Path)
        
    Returns:
        bool: True if successful, False otherwise
    """
    wheel_path = Path(wheel_path)
    
    if not wheel_path.exists():
        print(f"❌ Error: Wheel file not found: {wheel_path}")
        return False
    
    # Backup original wheel
    backup_path = wheel_path.with_suffix('.whl.backup')
    if not backup_path.exists():
        shutil.copy(wheel_path, backup_path)
        print(f"✓ Backed up original wheel to {backup_path.name}")
    else:
        print(f"ℹ️  Backup already exists: {backup_path.name}")
    
    # Find package.json in the wheel
    pkg_json_path = find_package_json_in_wheel(wheel_path)
    if not pkg_json_path:
        print(f"❌ Error: No package.json found in labextensions directory")
        return False
    
    print(f"📦 Found package.json: {pkg_json_path}")
    
    # Read the wheel
    try:
        with zipfile.ZipFile(wheel_path, 'r') as z_in:
            # Read and parse package.json
            content = z_in.read(pkg_json_path).decode('utf-8')
            data = json.loads(content)
            
            # Check if it has JupyterLab extension metadata
            if 'jupyterlab' not in data or '_build' not in data['jupyterlab']:
                print(f"⚠️  Warning: No JupyterLab extension metadata found")
                return False
            
            # Fix the backslash in load path
            old_load = data['jupyterlab']['_build']['load']
            new_load = old_load.replace('\\', '/')
            
            # Ensure it starts with ./ like working extensions
            if not new_load.startswith('./'):
                new_load = './' + new_load
            
            # Check if any changes needed
            if old_load == new_load:
                print(f"✓ Path already uses POSIX format: {old_load}")
                return True
            
            data['jupyterlab']['_build']['load'] = new_load
            
            print(f"📝 Fixing package.json:")
            print(f"   Old load: {old_load}")
            print(f"   New load: {new_load}")
            
            # Create temp directory for modified wheel
            with tempfile.TemporaryDirectory() as tmpdir:
                tmpdir = Path(tmpdir)
                
                # Extract all files
                z_in.extractall(tmpdir)
                
                # Write modified package.json
                pkg_json_file = tmpdir / pkg_json_path
                with open(pkg_json_file, 'w') as f:
                    json.dump(data, f, indent=2)
                
                # Create new wheel with fixed package.json
                with zipfile.ZipFile(wheel_path, 'w', zipfile.ZIP_DEFLATED) as z_out:
                    for file_path in tmpdir.rglob('*'):
                        if file_path.is_file():
                            arcname = file_path.relative_to(tmpdir)
                            z_out.write(file_path, arcname)
        
        print(f"✓ Fixed wheel saved to {wheel_path.name}")
        print(f"\n🔄 Verification:")
        
        # Verify the fix
        with zipfile.ZipFile(wheel_path, 'r') as z:
            content = z.read(pkg_json_path).decode('utf-8')
            data = json.loads(content)
            fixed_load = data['jupyterlab']['_build']['load']
            print(f"   Load path in fixed wheel: {fixed_load}")
            has_forward = '/' in fixed_load
            no_backslash = '\\' not in fixed_load
            starts_with_dot = fixed_load.startswith('./')
            
            print(f"   ✓ Uses forward slash: {has_forward}")
            print(f"   ✓ No backslashes: {no_backslash}")
            print(f"   ✓ Starts with ./: {starts_with_dot}")
            
            if has_forward and no_backslash and starts_with_dot:
                print("\n✅ Wheel fixed successfully!")
                return True
            else:
                print("\n⚠️  Warning: Some checks failed")
                return False
                
    except Exception as e:
        print(f"❌ Error processing wheel: {e}")
        return False


def main():
    """Main entry point with command-line argument handling."""
    if len(sys.argv) < 2:
        print(__doc__)
        print("\n❌ Error: No wheel file specified")
        print("\nUsage: python windows2linux.py <wheel_file>")
        print("Example: python windows2linux.py datax_now_front-0.1.60-py3-none-any.whl")
        sys.exit(1)
    
    wheel_path = sys.argv[1]
    
    print(f"🔧 Processing wheel: {Path(wheel_path).name}")
    print("=" * 60)
    
    if fix_wheel(wheel_path):
        print("\n" + "=" * 60)
        print("✅ Done! You can now rebuild your JupyterLite site.")
        sys.exit(0)
    else:
        print("\n" + "=" * 60)
        print("❌ Failed to fix wheel. Check errors above.")
        sys.exit(1)


if __name__ == '__main__':
    main()
