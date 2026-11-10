import unittest

from meeting_assistant.learning import select_learning


class LearningSelectionTests(unittest.TestCase):
    def test_selection_deduplicates_excludes_known_and_bounds_without_rewriting(self):
        original = {"items": [{"term": "部署", "pinyin": "bù shǔ", "quote": "部署新版本"},
                              {"term": "部署", "pinyin": "bù shǔ", "quote": "明天部署"},
                              {"term": "版本", "pinyin": "bǎn běn", "quote": "版本更新"},
                              {"term": "回滾", "pinyin": "huí gǔn", "quote": "需要回滾"}], "status": "ready"}
        result = select_learning(original, [{"term": "版本", "known": True}], limit=1)
        self.assertEqual([item["term"] for item in result["items"]], ["部署"])
        self.assertEqual(result["items"][0]["quote"], "部署新版本")
        self.assertEqual(result["selection"]["unique_unknown"], 2)
        self.assertEqual(len(original["items"]), 4)
        self.assertNotIn("known", original["items"][0])

    def test_invalid_limit_is_rejected(self):
        with self.assertRaises(ValueError):
            select_learning({"items": []}, limit=0)


if __name__ == "__main__":
    unittest.main()
