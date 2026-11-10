import tempfile
import unittest
from pathlib import Path

from meeting_assistant.instance import InstanceLock


class InstanceTests(unittest.TestCase):
    def test_only_one_owner_and_release_after_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            first = InstanceLock(root)
            try:
                with self.assertRaisesRegex(ValueError, "Another Meeting Assistant"):
                    InstanceLock(root)
            finally:
                first.close()
            second = InstanceLock(root)
            second.close()


if __name__ == "__main__":
    unittest.main()
